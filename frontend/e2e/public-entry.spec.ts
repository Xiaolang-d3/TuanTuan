import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "./test-fixtures";
import { tokenStorageKey } from "../src/features/auth/session";

const icpNumber = "鄂ICP备2026067631号-1";
const icpUrl = "https://beian.miit.gov.cn/";
const fallbackIcpLink = `body > a[href="${icpUrl}"]`;

async function mockHostedSite(page: Page, baseURL: string | undefined, responses: Record<string, unknown> = {}) {
  // Serve only local fixtures, even while exercising the production hostname.
  await page.route("https://xiaocheng.online/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\//, "/");
    if (path === "/auth/config") {
      await route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } });
      return;
    }
    if (path in responses) {
      await route.fulfill({ json: responses[path] });
      return;
    }
    if (path !== "/" && !path.startsWith("/assets/") && !/\.[a-z0-9]+$/i.test(path)) {
      await route.fulfill({ status: 404, json: { detail: `Unhandled test route: ${path}` } });
      return;
    }
    const local = new URL(url.pathname + url.search, baseURL);
    const response = await route.fetch({ url: local.href, maxRedirects: 0 });
    if (path !== "/") {
      await route.fulfill({ response });
      return;
    }
    const legacy = `<a href="${icpUrl}" style="position:fixed;bottom:2px;right:8px">${icpNumber}</a>`;
    await route.fulfill({ response, body: (await response.text()).replace("</body>", `${legacy}</body>`) });
  });
}

test("a minimal split sign-in page links to a public product page on desktop and mobile", async ({ page }) => {
  await page.route("**/auth/config", (route) => route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } }));
  const evidenceDir = resolve(import.meta.dirname, "../../output/playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.goto("/");

  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "登录本地账户" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "团团", exact: true })).toBeVisible();
    await expect(page.locator('img[src="/tuantuan-logo.png"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toHaveCount(0);
    const card = await page.locator(".auth-card").boundingBox();
    expect(card).not.toBeNull();
    if (viewport.width > 860) {
      const artwork = page.locator(".auth-artwork");
      await expect(artwork).toBeVisible();
      await expect(artwork.locator("img")).toHaveJSProperty("naturalWidth", 1448);
      const artworkBounds = await artwork.boundingBox();
      const sceneBounds = (await artwork.locator(".auth-mascot-scene").boundingBox())!;
      const captionBounds = (await artwork.locator(".auth-artwork-caption").boundingBox())!;
      expect(captionBounds.y).toBeGreaterThanOrEqual(sceneBounds.y + sceneBounds.height + 12);
      expect(captionBounds.x + captionBounds.width / 2).toBeCloseTo(artworkBounds!.x + artworkBounds!.width / 2, 0);
      expect(await artwork.locator(".auth-artwork-caption").evaluate(el => getComputedStyle(el).textAlign)).toBe("center");
      expect(card!.x + card!.width).toBeLessThan(artworkBounds!.x);
      expect(Math.abs(artworkBounds!.y + artworkBounds!.height / 2 - card!.y - card!.height / 2)).toBeLessThanOrEqual(4);
    } else {
      await expect(page.locator(".auth-artwork")).toBeHidden();
      expect(card!.x + card!.width / 2).toBeCloseTo(viewport.width / 2, 0);
    }
    expect(card!.width).toBeLessThanOrEqual(420);
    await page.screenshot({ path: resolve(evidenceDir, `login-only-${viewport.width}.png`), animations: "disabled" });
    const aboutLink = page.getByRole("link", { name: "关于 团团" });
    const aboutBounds = await aboutLink.boundingBox();
    expect(aboutBounds).not.toBeNull();
    expect(aboutBounds!.y + aboutBounds!.height).toBeLessThanOrEqual(card!.y);
    await aboutLink.click();
    await expect(page).toHaveURL(/#\/about$/);
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
    await expect(page.locator(".product-intro-brand img")).toHaveJSProperty("naturalWidth", 940);
    await expect(page.getByLabel("邮箱", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.locator(".product-intro-page").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: resolve(evidenceDir, `product-intro-${viewport.width}.png`), animations: "disabled" });
    await page.goBack();
    await expect(page.getByRole("heading", { name: "登录本地账户" })).toBeVisible();
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
    const loginHeading = page.getByRole("heading", { name: "登录本地账户" });
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
