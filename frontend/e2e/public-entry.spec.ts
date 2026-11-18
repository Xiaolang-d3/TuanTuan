import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";

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
  const icpNumber = "鄂ICP备2026067631号-1";
  const icpUrl = "https://beian.miit.gov.cn/";
  // Serve only local fixtures, even while exercising the production hostname.
  await page.route("https://xiaocheng.online/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/config") {
      await route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } });
      return;
    }
    const local = new URL(url.pathname + url.search, baseURL);
    const response = await route.fetch({ url: local.href, maxRedirects: 0 });
    if (url.pathname !== "/") {
      await route.fulfill({ response });
      return;
    }
    const legacy = `<a href="${icpUrl}" style="position:fixed;bottom:2px;right:8px">${icpNumber}</a>`;
    await route.fulfill({ response, body: (await response.text()).replace("</body>", `${legacy}</body>`) });
  });
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("https://xiaocheng.online/");
  await expect(page.getByRole("heading", { name: "登录本地账户" })).toBeVisible();

  const footer = page.getByRole("contentinfo", { name: "网站页脚" });
  async function checkRegistration() {
    const link = footer.getByRole("link", { name: icpNumber });
    await expect(link).toHaveAttribute("href", icpUrl);
    await expect(page.getByRole("link", { name: icpNumber, exact: true })).toHaveCount(1);
    await expect(page.locator(`body > a[href="${icpUrl}"]`)).toBeHidden();
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    const bounds = (await link.boundingBox())!;
    expect(bounds.x + bounds.width / 2).toBeCloseTo(375 / 2, 0);
  }

  await checkRegistration();
  await footer.getByRole("link", { name: "产品介绍" }).click();
  await expect(page).toHaveURL(/#\/about$/);
  await checkRegistration();
  await footer.getByRole("link", { name: "返回登录" }).click();
  await expect(page.getByRole("heading", { name: "登录本地账户" })).toBeVisible();
});
